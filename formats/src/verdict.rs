use serde::{Deserialize, Serialize};

use crate::primitives::FormatError;

/// The judge's verdict: an outcome and the one coarse reason recorded publicly (R5.5).
/// JSON: `{"outcome":"ZERO","reason":"below_minimum_theft"}`. A reason always belongs to
/// exactly one outcome; a mismatched pair is refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "VerdictJson", into = "VerdictJson")]
#[cfg_attr(
    feature = "near",
    derive(
        borsh::BorshSerialize,
        borsh::BorshDeserialize,
        borsh::BorshSchema,
        schemars::JsonSchema
    )
)]
pub struct Verdict {
    reason: Reason,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(
    feature = "near",
    derive(
        borsh::BorshSerialize,
        borsh::BorshDeserialize,
        borsh::BorshSchema,
        schemars::JsonSchema
    )
)]
pub enum Outcome {
    #[serde(rename = "PAYS")]
    Pays,
    #[serde(rename = "ZERO")]
    Zero,
    #[serde(rename = "INVALID")]
    Invalid,
}

/// The coarse reasons. Deliberately few: a ZERO says only that the score fell short, never
/// by how much, so a near-miss leaks nothing (R5.5, user story 36).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(
    feature = "near",
    derive(
        borsh::BorshSerialize,
        borsh::BorshDeserialize,
        borsh::BorshSchema,
        schemars::JsonSchema
    )
)]
pub enum Reason {
    /// PAYS: the score reached the minimum theft (R3.8).
    MinimumTheftReached,
    /// ZERO: the score is below the minimum theft, including no theft at all (R3.8).
    BelowMinimumTheft,
    /// INVALID: the exploit can't be decoded or run (R3.11).
    MalformedExploit,
    /// INVALID: the account sealed in the exploit isn't the claimant (R5.4).
    AccountMismatch,
    /// INVALID: a transaction is sent by an account that exists at the claim's block (R4.1).
    ExistingSender,
    /// INVALID: the replay read state the claim doesn't prove, or a proof doesn't match
    /// the claim's block (R4.5).
    UnprovenState,
    /// INVALID: the independent RPCs agree on a different hash for the claim's block (R2.8).
    BlockNotConfirmed,
    /// INVALID: the claim's block is outside the recency limit of its submission (R2.8).
    StaleBlock,
}

impl Reason {
    pub const ALL: [Reason; 8] = [
        Reason::MinimumTheftReached,
        Reason::BelowMinimumTheft,
        Reason::MalformedExploit,
        Reason::AccountMismatch,
        Reason::ExistingSender,
        Reason::UnprovenState,
        Reason::BlockNotConfirmed,
        Reason::StaleBlock,
    ];

    pub fn outcome(self) -> Outcome {
        match self {
            Reason::MinimumTheftReached => Outcome::Pays,
            Reason::BelowMinimumTheft => Outcome::Zero,
            _ => Outcome::Invalid,
        }
    }
}

impl Verdict {
    pub fn new(reason: Reason) -> Self {
        Self { reason }
    }
    pub fn outcome(self) -> Outcome {
        self.reason.outcome()
    }
    pub fn reason(self) -> Reason {
        self.reason
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct VerdictJson {
    outcome: Outcome,
    reason: Reason,
}

impl TryFrom<VerdictJson> for Verdict {
    type Error = FormatError;
    fn try_from(json: VerdictJson) -> Result<Self, FormatError> {
        if json.reason.outcome() == json.outcome {
            Ok(Verdict::new(json.reason))
        } else {
            Err(FormatError(format!(
                "reason {:?} doesn't belong to outcome {:?}",
                json.reason, json.outcome
            )))
        }
    }
}

impl From<Verdict> for VerdictJson {
    fn from(v: Verdict) -> Self {
        VerdictJson {
            outcome: v.outcome(),
            reason: v.reason,
        }
    }
}
