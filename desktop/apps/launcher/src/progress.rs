//! Progress reported to the window while an install runs.

use serde::Serialize;

/// Stage of the install pipeline.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Download,
    Verify,
    Install,
}

impl Phase {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Download => "download",
            Self::Verify => "verify",
            Self::Install => "install",
        }
    }
}

/// One progress tick; `total` is `None` when the server sends no length.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressEvent {
    pub phase: &'static str,
    pub received: u64,
    pub total: Option<u64>,
}

impl ProgressEvent {
    pub fn new(phase: Phase, received: u64, total: Option<u64>) -> Self {
        Self {
            phase: phase.as_str(),
            received,
            total,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_the_phase_and_counts() {
        let event = ProgressEvent::new(Phase::Download, 10, Some(100));
        let json = serde_json::to_string(&event).expect("serialize");

        assert_eq!(json, r#"{"phase":"download","received":10,"total":100}"#);
    }
}
